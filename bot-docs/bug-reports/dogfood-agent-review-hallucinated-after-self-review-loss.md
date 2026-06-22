# Dogfood Bug: Agent Hallucinated Review After Self-Review Replaced Original Answer

Date: 2026-06-21

Session: `Dogfood Count Fix Review 1782023338711`

Session ID: `f3a8297e-3b8b-4032-bdf5-40caa0e3ef5d`

## Summary

During dogfooding, the QA agent performed a read-only review of the current Kikx working tree. Its first visible final answer was incorrectly replaced by completion-review meta text (`Self-review of the draft/report...`) instead of the actual review report.

After fixing the completion-review guard, a follow-up asked the agent to provide the actual report. Because the original substantive report had never been persisted, the agent produced a fabricated report referencing nonexistent Go files such as:

- `pkg/session/session_state.go`
- `pkg/session/message_counter.go`
- `pkg/api/session_handler.go`

The actual Kikx changes were in JavaScript modules such as:

- `src/client/state/session-state-utils.mjs`
- `src/core/runtime/frame-runtime.mjs`
- `src/core/plugins/agent-script-template.mjs`
- `src/core/plugins/agent-interface.mjs`
- `src/core/compaction/compaction-service.mjs`

## Impact

This is dangerous for an agent harness because a user can receive a confident, concrete-looking report that is detached from the actual repository. It also shows that losing or suppressing a substantive draft during completion review creates unrecoverable context loss unless the agent re-reads source material.

## Current Fix Already Applied

`AgentInterface.runCompletionReview` now snapshots the pre-review draft before invoking the provider. If completion review emits meta-review text, Kikx preserves the substantive draft.

Covered by:

- `AgentInterface preserves the draft when completion self-review emits meta-review text`

## Remaining Work

The harness still needs a guard for follow-up answers that claim file/function specifics without grounding in current visible context or fresh tool reads. Possible fixes:

- When a user asks for a report that depends on prior non-visible draft/tool context, require the agent to re-read or search before answering.
- Make tool outputs and prior draft summaries easier for agents to retrieve through session search/output search.
- Add a "grounding required" instruction or deterministic check for reports containing file paths not present in session context/tool outputs.
- Consider storing rejected completion-review drafts as hidden diagnostic data so they can be recovered without showing them to the user.
