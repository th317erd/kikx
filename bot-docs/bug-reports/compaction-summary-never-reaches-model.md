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

Map `CompactionFrame` to a `user` message in each provider, before the hidden
guard:

```js
if (isCompactionFrame(frame))
  return compactionFrameToMessage(frame);
```

where the message is:

```
[Compacted context memory — earlier turns summarized]
<content.summary || content.text>
```

Files changed:
- `kikx-plugin-ollama/index.mjs` — `frameToOllamaMessage` + helpers.
- `kikx-plugin-codex/index.mjs` — `frameToOpenAIMessage` + helpers.

## Regression coverage

- `kikx-plugin-ollama/spec/setup-spec.mjs` — "includes a CompactionFrame summary
  in the model prompt".
- `kikx-plugin-codex/spec/setup-spec.mjs` — same.

Each drives a real `agent.run()` with a `hidden` `CompactionFrame` in
`params.frames` and asserts the summary text appears in the outgoing model
request.

## Why tests missed it

Core specs asserted the compaction frame is *in* `contextMemory.frames`, and
service specs asserted `content.summary` is *set*. No test drove a summary
through a provider's `buildXInput`. The gap was precisely the provider boundary.

## Deploy note

Plugins are baked into the dogfood container image at pinned refs, so the fix
does not affect the running instance until the plugin repos are pushed and the
container is redeployed (`kikx-docker/deploy.sh`).
