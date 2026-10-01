# Bug: compaction summaries never reach the model (agent "memory glitches")

**Status:** FIXED (pending deploy)
**Reported:** 2026-10-01 (owner, dogfooding session "Kikx")
**Severity:** High — silent, recurring loss of conversational memory.

## Symptom

An agent in the dogfood instance appeared to "randomly" forget context. It was
not random: it correlated exactly with context compaction events. Immediately
after a compaction, the agent lost nearly everything before the compaction
boundary and could not recall prior work, despite a summary having been
generated.

## Root cause

Compaction replaces the turns before a boundary with a single `CompactionFrame`
whose `content.summary` is the model's only memory of that history. That frame
is created **`hidden: true`** (it is an internal UI artifact), and every
frame→message mapper in `ask()`-style providers began with:

```js
if (!frame || frame.deleted || frame.hidden)
  return null;
```

Neither mapper had a `CompactionFrame` case, and neither read
`content.summary`. So the summary was discarded before the provider request was
built.

The core was correct: `FrameContextBuilder.build()` deliberately re-includes the
latest compaction frame at the head of `contextMemory.frames`
(`frame-context-builder.mjs`, `isCompactionFrame` bypass for hidden), and
`AgentRouteFramePlugin` passes those frames to the provider as
`params.frames`/`params.sessionFrames`. The loss was entirely at the provider
boundary. No other code path injects the summary.

Affected providers (implement `ask()` and consume `params.frames`):
`kikx-plugin-ollama` (Zav), `kikx-plugin-codex`.

`kikx-plugin-claude` and `kikx-plugin-google` do not implement the v2 `ask()`
loop and consume `params.messages` (not frames), so they have no compaction path
here.

## Evidence

Session `a07faa16-4eed-44a9-b823-f2e9c0c10df5` ("Kikx"), 1735 frames, 12
completed compactions. At the latest compaction (boundary order `142857`):

- 64 visible user/agent messages were summarized and erased from context.
- Only 7 messages remained after the boundary.
- The summary is ~13 KB (~3.2k tokens) and was dropped.

Simulating the pre-fix mapper over the real context window (244 frames after the
boundary): only 5–7 model messages survived, and the compaction frame mapped to
`null`.

## Fix

### Structural fix (supersedes the local per-plugin patch)

Compaction is a *core* concept but the frame→model projection lived in each
*adapter*, so a new core frame type silently vanished everywhere it was not
taught. Centralize the decision in core:

`src/core/plugins/agent-model-context.mjs` now owns frame→turn mapping:
`frameToModelTurn`, `buildModelMessages`, `resolvePromptContent`, compaction
handling, and the session system prompt. `AgentInterface` re-exposes them as
statics. Providers call `this.constructor.buildModelMessages(params)` and keep
only their API-specific wrapping; they no longer each re-implement (or
miss) frame handling.

- `kikx-plugin-ollama/index.mjs` — deleted its local mapper; uses the shared one.
- `kikx-plugin-codex/index.mjs` — same.
- A future adapter (or a new internal frame type) is now handled once.

Shared handling includes compaction: `CompactionFrame` (or
`content.kind === 'compaction_frame'`) maps to a user turn

```
[Compacted context memory — earlier turns summarized]
<content.summary || content.text>
```

before the hidden-frame guard.

### Regression coverage

- `kikx/spec/core/plugins/agent-model-context-spec.mjs` (10 cases) — the shared
  projection, including a hidden `CompactionFrame`, by-type and by-kind.
- `kikx-plugin-ollama/spec/setup-spec.mjs` — the summary appears in the outgoing
  `/api/chat` request.
- `kikx-plugin-codex/spec/setup-spec.mjs` — the summary appears in the outgoing
  `/v1/responses` request.

## Why tests missed it

Core specs asserted the compaction frame is *in* `contextMemory.frames`, and
service specs asserted `content.summary` is *set*. No test drove a summary
through a provider's `buildXInput`. The gap was precisely the provider boundary.

## Deploy note

Plugins are baked into the dogfood container image at pinned refs, so the fix
does not affect the running instance until the plugin repos are pushed and the
container is redeployed (`kikx-docker/deploy.sh`).
