# Context Compaction

Kikx uses asynchronous context compaction to keep agent memory within model limits without freezing the session during normal operation.

## Source Of Truth

- `src/core/compaction/agent-compaction-template.mjs` builds the one-shot prompt sent to the compactor agent.
- `src/core/compaction/frame-context-builder.mjs` decides which frames an agent sees and which frame window should be compacted.
- `src/core/compaction/compaction-service.mjs` starts background compaction and writes `CompactionFrame` records.
- `src/core/agents/agent-route-frame-plugin.mjs` asks the compaction service for the frame memory before invoking an agent provider.

## Frame Contract

Compaction records are hidden frames:

- `type`: `CompactionFrame`
- `content.kind`: `compaction_frame`
- `content.summary`: compacted context memory
- `content.boundaryFrameID`: last frame summarized
- `content.boundaryOrder`: order of the last summarized frame

The frame is persisted after compaction completes. It is hidden from normal chat display, but it is included in future agent memory.

## Runtime Behavior

When context usage crosses the configured trigger ratio, Kikx starts compaction in the background and continues routing with the current context.

If the context reaches the hard limit while a compaction is still pending, Kikx waits for that compaction, rebuilds memory from the resulting `CompactionFrame`, and then continues.

Agent memory is compaction-aware: context starts at the most recent completed `CompactionFrame`, then includes all following non-deleted visible frames.

The compaction prompt itself is budgeted separately. The compaction input window is capped to:

```text
compaction_agent_context_tokens - compaction_instructions_tokens
```

This leaves room for both the instructions and the frame memory being compressed.

## Manual Compaction

Users can run `/compact` to force a checkpoint regardless of current context usage.

Manual compaction creates a visible `CompactionFrame` immediately with `content.status = "running"`. When the one-shot compactor returns, Kikx updates that same frame to `content.status = "complete"` and stores the summary on `content.summary`.

Automatic compactions remain hidden. Manual compactions are visible because the user explicitly requested the operation and should be able to see that it is running or completed.
