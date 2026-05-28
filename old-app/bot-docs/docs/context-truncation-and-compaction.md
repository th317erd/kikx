# Context Truncation & Compaction — Research Notes

*Researched: 2026-03-18*

---

## Overview

The V2 system has a **two-layer context truncation** system that fires before each API call. Compaction (AI-driven summarization) is **not implemented** in V2 — only legacy V1 code exists in `old-app/`. This document covers the full picture: what's there, what's missing, and known issues.

---

## 1. Current Truncation System

### Key Files

| File | Purpose |
|------|---------|
| `src/core/interaction/context-truncation.mjs` | Core truncation logic (257 lines) |
| `src/core/interaction/index.mjs:329-330` | Invocation point |
| `src/core/interaction/behaviors-reinjection.mjs` | Re-injects behaviors after truncation |
| `src/core/interaction/instructions-reinjection.mjs` | Re-injects agent instructions after truncation |
| `spec/core/interaction/context-truncation-spec.mjs` | 85+ test cases |

### Layer 1: Per-Message Truncation (`truncateContent`)

- **Limit:** `DEFAULT_MAX_CONTENT_LENGTH = 8000` characters (~2K tokens)
- **What it does:** Caps individual large messages by truncating their content
- **Tool-call messages are never truncated** (arguments must be preserved)
- Appends a marker: `[...content truncated — original was N characters]`
- Does NOT mutate the input array

### Layer 2: Conversation Truncation (`truncateConversation`)

- **Limit:** `DEFAULT_MAX_TOTAL_CHARS = 600000` characters (~150K tokens)
- **What it does:** Drops oldest messages until total size fits in budget
- Guarantees: last user message is NEVER dropped
- Tool call ↔ tool result pairs are kept/dropped together (preserves conversation coherence)
- Prepends marker: `[Earlier conversation history was truncated. N messages removed.]`
- Does NOT mutate the input array

### Invocation Order (in `startInteraction`)

```
buildMessages()
  → truncateContent()
  → truncateConversation()
  → reinjectBehaviors()       ← adds content AFTER truncation
  → reinjectInstructions()    ← adds content AFTER truncation
  → injectPrimer()            ← adds content on first message
  → [API call]
```

### Re-injection (Behaviors + Instructions)

After truncation drops the primer, agent behaviors and instructions are re-injected to ensure the agent still follows its rules. Re-injection conditions:
1. Primer was NOT injected this turn
2. Agent has behaviors/instructions
3. Truncation occurred (detected by marker message)
4. A non-marker user message exists to inject into

**Issue:** Re-injection happens AFTER the truncation budget was balanced — the added content is never re-checked against limits (see Known Issues below).

---

## 2. Token Counting

The system uses **character counts as a proxy for tokens** — no actual token counting library is used.

- Rule of thumb: ~4 chars = 1 token for English
  - 8,000 chars → ~2,000 tokens
  - 600,000 chars → ~150,000 tokens

**Actual token counts** are only known AFTER an API call completes (from `message_start` and `message_delta` events). These are stored in the `Token` model but do not influence truncation decisions.

There is **no pre-execution token estimation** utility.

---

## 3. Plugin Model Exports & Context Limits

### Current State of the Claude Plugin

```javascript
// kikx-plugin-claude/index.mjs
const DEFAULT_MODEL           = 'claude-sonnet-4-20250514';
const DEFAULT_MAX_TOKENS      = 16000;   // max output tokens
const DEFAULT_THINKING_BUDGET = 10000;   // extended thinking budget
```

- Agents can override `model`, `maxTokens`, `thinkingBudget` via their config
- **No model registry** — plugin does not export available models or their context windows
- **No validation** — nothing checks that `maxTokens` is within the model's actual limits
- Claude Sonnet 4's actual context window (200K tokens) is **not defined anywhere in code**
- No mechanism exists for the UI to populate a model selector from plugin data

### What's Needed

Plugins should publish a model manifest: available model names, context window sizes, output token limits, and cost rates. This enables:
1. UI model selection dropdowns populated dynamically from plugin data
2. Truncation to use the correct character budget for the active model
3. Validation that `maxTokens` doesn't exceed the model's output limit

---

## 4. Compaction

### V1 Legacy (NOT in V2)

`old-app/server/lib/compaction.mjs` (271 lines) — archived, not used:
- Threshold-triggered: 15 messages (min), 25 messages (max)
- 5-second debounce to avoid compacting during active typing
- AI-driven: asked the agent itself to summarize the conversation
- Stored summary + snapshot as a "compact frame" in the DB

### V2 Status

- **Not implemented.** No plan YAML exists for it.
- The current alternative is the **Agent Memory Context** system (completed 2026-03-11), which persists key information across sessions explicitly.
- Truncation (drop oldest) is the current fallback.

---

## 5. Known Issues

### Issue 1: Character Estimation Mismatch

Character-to-token ratio varies significantly:
- English prose: ~4 chars/token (ratio holds reasonably well)
- Code / JSON: often denser — can be 3 chars/token or less
- Tool definitions, API format overhead: adds tokens not counted in content chars
- **Risk:** Assembled messages could exceed Claude's actual 200K context window, causing API rejection

### Issue 2: Re-injection Can Exceed Budget

```
truncateConversation()   → balanced to 600K chars
reinjectBehaviors()      → +5KB behaviors block
reinjectInstructions()   → +5KB instructions
injectPrimer()           → +10KB primer (first message)
```
The final assembled payload is never re-checked against limits. Large behaviors/primer could push content over.

### Issue 3: Massive Tool Results Can Hold Budget Hostage

Tool-call messages are never content-truncated (by design — arguments are required). However, a `tool-result` with 500K chars of output almost fills the entire conversation budget alone, leaving no room for actual message history. The "last user message" guarantee keeps that one but everything else gets dropped.

### Issue 4: No Model Awareness

Truncation limits are hardcoded constants — not derived from the active model's actual context window. When Claude releases models with different windows, the limits must be manually updated. No validation ensures the assembled payload fits.

### Issue 5: Post-Injection No Re-Truncation

After re-injecting behaviors/instructions and the primer, no second truncation pass runs. If the injected content is large, the final payload can exceed the model's limits.

---

## 6. Test Coverage

`spec/core/interaction/context-truncation-spec.mjs` — 85+ tests, comprehensive:
- Empty/null inputs
- Boundary conditions (exact limit, limit+1)
- Tool pair cohesion
- Last user message preservation
- Metadata preservation (frameID, sourceAgentID)
- No-mutation guarantees
- Mixed message types

All tests passing as of 2026-03-15.

---

## 7. Recommendations

1. **Model Registry in Plugins** — each plugin exports a static model manifest (name, contextWindow, maxOutputTokens, pricing). Used for UI selectors and truncation budget calculation.

2. **Token-Aware Truncation** — use actual context window from model registry to calculate character budget dynamically instead of hardcoded constants.

3. **Post-Injection Re-truncation** — after behaviors/instructions/primer injection, run a final check and re-truncate if needed.

4. **Tool-Result Size Warning/Truncation** — large tool results should be capped or warned about; a 500K-char shell output is usually not useful in full.

5. **Compaction (Optional)** — for very long sessions, AI-driven summarization of old context could replace simple dropping. The memory system provides an alternative approach.
